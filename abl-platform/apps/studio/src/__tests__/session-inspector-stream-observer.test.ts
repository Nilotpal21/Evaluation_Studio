import { describe, it, expect, vi } from 'vitest';
import { createObservedArchStream } from '../lib/arch-ai/stream-observer';
import type { ArchSSEEvent } from '@agent-platform/arch-ai';
import type { AuditLogEntry } from '@agent-platform/arch-ai';

describe('createObservedArchStream — session inspector hierarchy', () => {
  function createTestObserver(turnId?: string) {
    const emitted: ArchSSEEvent[] = [];
    const auditEntries: AuditLogEntry[] = [];
    const auditSink = {
      emit: (entry: AuditLogEntry) => auditEntries.push(entry),
      emitPayload: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(),
    };

    const observer = createObservedArchStream({
      tenantId: 'tenant1',
      userId: 'user1',
      sessionId: 'session1',
      projectId: 'proj1',
      phase: 'INTERVIEW',
      turnId,
      emit: (event) => emitted.push(event),
      close: () => {},
      auditSink,
    });

    return { observer, emitted, auditEntries, auditSink };
  }

  it('exposes setTurnId method', () => {
    const { observer } = createTestObserver();
    expect(typeof observer.setTurnId).toBe('function');
  });

  it('maps tool_call events with hierarchy fields', () => {
    const { observer, auditEntries } = createTestObserver('turn_abc');

    observer.emit({
      type: 'tool_call',
      toolCallId: 'tc1',
      toolName: 'ask_user',
      input: { question: 'hello' },
    } as unknown as ArchSSEEvent);

    const toolEntry = auditEntries.filter((e) => e.category === 'tool_execution')[0];
    expect(toolEntry).toBeDefined();
    expect(toolEntry.turnId).toBe('turn_abc');
    expect(toolEntry.spanKind).toBe('tool_call');
    expect(toolEntry.nestingDepth).toBe(3);
    expect(toolEntry.summary).toBe('ask_user called');
  });

  it('redacts non-allowlisted tool input payloads', () => {
    const { observer, auditSink } = createTestObserver('turn_secret');

    observer.emit({
      type: 'tool_call',
      toolCallId: 'tc_secret',
      toolName: 'collect_secret',
      input: { token: 'sk-secret1234567890', label: 'API key' },
    } as unknown as ArchSSEEvent);

    expect(auditSink.emitPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'tc_secret',
        payloadType: 'tool_input',
        toolName: 'collect_secret',
        content: JSON.stringify({
          _redacted: true,
          reason: 'tool_input_not_allowlisted',
          toolName: 'collect_secret',
          inputKeys: ['token', 'label'],
        }),
      }),
    );
  });

  it('maps done events with completion to llm_call audit entries', () => {
    const { observer, auditEntries } = createTestObserver('turn_xyz');

    observer.emit({
      type: 'done',
      suggestions: [],
      completion: {
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        finishReason: 'stop',
        stepCount: 1,
        latencyMs: 2500,
        model: 'gpt-4o',
      },
    } as unknown as ArchSSEEvent);

    const llmEntry = auditEntries.filter((e) => e.category === 'llm_call')[0];
    expect(llmEntry).toBeDefined();
    expect(llmEntry.turnId).toBe('turn_xyz');
    expect(llmEntry.spanKind).toBe('llm_call');
    expect(llmEntry.nestingDepth).toBe(2);
    expect(llmEntry.tokens?.input).toBe(100);
    expect(llmEntry.tokens?.output).toBe(50);
    expect(llmEntry.tokens?.total).toBe(150);
    expect(llmEntry.durationMs).toBe(2500);
  });

  it('does not emit llm_call for done without completion', () => {
    const { observer, auditEntries } = createTestObserver();

    observer.emit({
      type: 'done',
      suggestions: [],
    } as unknown as ArchSSEEvent);

    const llmEntries = auditEntries.filter((e) => e.category === 'llm_call');
    expect(llmEntries).toHaveLength(0);
  });

  it('auto-extracts turnId from TurnEvent-shaped objects', () => {
    const { observer, auditEntries } = createTestObserver();

    // Simulate a TurnEvent (turn_started) passing through as ArchSSEEvent
    observer.emit({
      type: 'turn_started',
      turnId: 'turn_auto_detected',
      sessionId: 'session1',
      eventId: 'evt1',
      seq: 0,
      schemaVersion: 2,
      timestamp: Date.now(),
      userMessageId: 'msg1',
    } as unknown as ArchSSEEvent);

    // The turn boundary should have been emitted with the detected turnId
    const turnEntry = auditEntries.filter(
      (e) => e.category === 'system_event' && e.spanKind === 'turn',
    )[0];
    expect(turnEntry).toBeDefined();
    expect(turnEntry.turnId).toBe('turn_auto_detected');
  });

  it('enriches phase_transition with hierarchy fields', () => {
    const { observer, auditEntries } = createTestObserver('turn_123');

    observer.emit({
      type: 'phase_transition',
      from: 'INTERVIEW',
      to: 'BLUEPRINT',
    } as unknown as ArchSSEEvent);

    const phaseEntry = auditEntries.filter((e) => e.category === 'phase_transition')[0];
    expect(phaseEntry).toBeDefined();
    expect(phaseEntry.turnId).toBe('turn_123');
    expect(phaseEntry.spanKind).toBe('phase');
    expect(phaseEntry.nestingDepth).toBe(0);
    expect(phaseEntry.phaseLabel).toBe('BLUEPRINT');
  });
});
