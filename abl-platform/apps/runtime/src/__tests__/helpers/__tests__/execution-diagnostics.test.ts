import { describe, it, expect, vi } from 'vitest';
import { formatSessionDiagnostics, withDiagnostics } from '../execution-diagnostics.js';
import { createBaseSession } from '../../execution/pre-refactor/helpers/test-session-factory.js';

describe('formatSessionDiagnostics', () => {
  it('includes session identity (agentName, isComplete)', () => {
    const session = createBaseSession({ agentName: 'BookingAgent', isComplete: true });
    const output = formatSessionDiagnostics(session);

    expect(output).toContain('Agent Name:      BookingAgent');
    expect(output).toContain('Is Complete:     true');
  });

  it('includes data values', () => {
    const session = createBaseSession({
      data: {
        values: { city: 'London', count: 42 },
        gatheredKeys: new Set<string>(),
      },
    });
    const output = formatSessionDiagnostics(session);

    expect(output).toContain('city: London');
    expect(output).toContain('count: 42');
  });

  it('includes gathered keys', () => {
    const session = createBaseSession({
      data: {
        values: { name: 'Alice', age: 30 },
        gatheredKeys: new Set(['name', 'age']),
      },
    });
    const output = formatSessionDiagnostics(session);

    expect(output).toContain('Gathered Keys: [name, age]');
  });

  it('includes thread info with ACTIVE marker', () => {
    const session = createBaseSession({
      activeThreadIndex: 1,
      threads: [
        {
          agentName: 'ParentAgent',
          status: 'complete',
          currentFlowStep: null,
          conversationHistory: [],
          waitingForInput: [],
        } as any,
        {
          agentName: 'ChildAgent',
          status: 'active',
          currentFlowStep: 'step2',
          conversationHistory: [{ role: 'user', content: 'hi' }],
          waitingForInput: [],
        } as any,
      ],
    });
    const output = formatSessionDiagnostics(session);

    expect(output).toContain('THREADS: (2 total, active index: 1)');
    expect(output).toMatch(/\[0\]\s+agent=ParentAgent/);
    expect(output).toMatch(/\[1\]\s+\[ACTIVE\]\s+agent=ChildAgent/);
    expect(output).toContain('status=active');
    expect(output).toContain('step=step2');
  });

  it('includes mock LLM call info when provided', () => {
    const session = createBaseSession();
    const mockClient = {
      calls: [
        {
          systemPrompt: 'You are helpful.',
          messages: [{ role: 'user', content: 'hello' }],
          tools: [{ name: 'search' }, { name: 'lookup' }],
        },
        {
          systemPrompt: 'You are helpful.',
          messages: [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi' },
          ],
          tools: [{ name: 'search' }],
        },
      ],
    };
    const output = formatSessionDiagnostics(session, mockClient);

    expect(output).toContain('LLM CALLS: (2 total)');
    expect(output).toContain('[0] msgs=1 tools=[search, lookup]');
    expect(output).toContain('[1] msgs=2 tools=[search]');
  });

  it('includes trace events when provided', () => {
    const session = createBaseSession();
    const traces = [
      { type: 'step:enter', data: { stepName: 'greet', sessionId: 's1', timestamp: 123 } },
      { type: 'gather:field', data: { field: 'name', value: 'Alice', sessionId: 's1' } },
    ];
    const output = formatSessionDiagnostics(session, undefined, traces);

    expect(output).toContain('TRACE EVENTS: (2 total, showing last 20)');
    expect(output).toContain('step:enter: stepName=greet');
    expect(output).toContain('gather:field: field=name value=Alice');
  });

  it('handles empty/minimal session gracefully', () => {
    const session = createBaseSession();
    const output = formatSessionDiagnostics(session);

    expect(output).toContain('SESSION DIAGNOSTICS');
    expect(output).toContain('Agent Name:      test-agent');
    expect(output).toContain('Is Complete:     false');
    expect(output).toContain('THREADS: (0 total, active index: 0)');
    expect(output).toContain('CONVERSATION HISTORY: (0 messages, showing last 6)');
    // No LLM CALLS or TRACE EVENTS sections
    expect(output).not.toContain('LLM CALLS');
    expect(output).not.toContain('TRACE EVENTS');
  });
});

describe('withDiagnostics', () => {
  it('passes through when assertion succeeds', () => {
    const session = createBaseSession({ agentName: 'TestAgent' });

    // Should not throw
    withDiagnostics(session, undefined, undefined, () => {
      expect(session.agentName).toBe('TestAgent');
    });
  });

  it('dumps diagnostics and re-throws on assertion failure', () => {
    const session = createBaseSession({ agentName: 'ActualAgent' });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      expect(() => {
        withDiagnostics(session, undefined, undefined, () => {
          expect(session.agentName).toBe('ExpectedAgent');
        });
      }).toThrow();

      // Verify diagnostics were dumped to console.error
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      const dumpedOutput = consoleErrorSpy.mock.calls[0][0] as string;
      expect(dumpedOutput).toContain('SESSION DIAGNOSTICS');
      expect(dumpedOutput).toContain('Agent Name:      ActualAgent');
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
