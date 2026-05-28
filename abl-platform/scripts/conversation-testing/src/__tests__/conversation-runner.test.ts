import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMClient, LLMMessage, Scenario } from '../types.js';

interface MockWebSocketInstance {
  readyState: number;
  sentPayloads: string[];
  emit(event: string, ...args: unknown[]): void;
}

const { wsInstances } = vi.hoisted(() => ({
  wsInstances: [] as MockWebSocketInstance[],
}));

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'message-id-1'),
}));

vi.mock('ws', () => ({
  default: class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState = MockWebSocket.OPEN;
    private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    readonly sentPayloads: string[] = [];

    constructor(_url: string, _protocols: string[]) {
      wsInstances.push(this);
    }

    on(event: string, handler: (...args: unknown[]) => void) {
      const existing = this.handlers.get(event) ?? [];
      existing.push(handler);
      this.handlers.set(event, existing);
    }

    send(payload: string) {
      this.sentPayloads.push(payload);
    }

    close() {
      this.readyState = MockWebSocket.CLOSED;
    }

    emit(event: string, ...args: unknown[]) {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args);
      }
    }
  },
}));

import { runConversation } from '../conversation-runner.js';

const scenario: Scenario = {
  intent: 'billing_dispute',
  persona: 'Frustrated customer',
  goal: 'Get help',
  behavior: 'brief',
  endCondition: 'When the agent confirms the next step',
};

function createLlm(response: string): LLMClient {
  return {
    chat: vi.fn(async (_messages: LLMMessage[]) => response),
  };
}

const testProtocolBuilder = () => ['protocol-token'];

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('runConversation', () => {
  beforeEach(() => {
    wsInstances.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('marks a premature close before session_ended as failed', async () => {
    const transcriptPromise = runConversation(
      'sdk-token',
      scenario,
      createLlm('[END_CONVERSATION]'),
      {
        scenarioIndex: 0,
        protocolBuilder: testProtocolBuilder,
      },
    );

    const ws = wsInstances[0];
    ws.emit('open');
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'session_start', sessionId: 's-1' })));
    await flushMicrotasks();

    expect(ws.sentPayloads).toContain(JSON.stringify({ type: 'end_session' }));

    ws.emit('close');

    await expect(transcriptPromise).resolves.toMatchObject({
      outcome: 'failed',
      error: 'WebSocket closed before session_ended acknowledgement',
    });
  });

  it('keeps a normal end_session plus session_ended flow successful', async () => {
    const transcriptPromise = runConversation(
      'sdk-token',
      scenario,
      createLlm('[END_CONVERSATION]'),
      {
        scenarioIndex: 0,
        protocolBuilder: testProtocolBuilder,
      },
    );

    const ws = wsInstances[0];
    ws.emit('open');
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'session_start', sessionId: 's-1' })));
    await flushMicrotasks();

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'session_ended' })));

    await expect(transcriptPromise).resolves.toMatchObject({
      outcome: 'success',
    });
  });

  it('preserves max_turns only after graceful shutdown acknowledgement', async () => {
    vi.useFakeTimers();

    const transcriptPromise = runConversation('sdk-token', scenario, createLlm('Need more help'), {
      scenarioIndex: 0,
      maxTurns: 0,
      protocolBuilder: testProtocolBuilder,
    });

    const ws = wsInstances[0];
    ws.emit('open');
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'session_start', sessionId: 's-1' })));
    await flushMicrotasks();

    expect(ws.sentPayloads).toContain(JSON.stringify({ type: 'end_session' }));

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'session_ended' })));

    await expect(transcriptPromise).resolves.toMatchObject({
      outcome: 'max_turns',
    });
  });

  it('fails the run when session_ended never arrives within the grace period', async () => {
    vi.useFakeTimers();

    const transcriptPromise = runConversation(
      'sdk-token',
      scenario,
      createLlm('[END_CONVERSATION]'),
      {
        scenarioIndex: 0,
        protocolBuilder: testProtocolBuilder,
      },
    );

    const ws = wsInstances[0];
    ws.emit('open');
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'session_start', sessionId: 's-1' })));
    await flushMicrotasks();

    expect(ws.sentPayloads).toContain(JSON.stringify({ type: 'end_session' }));

    // Advance past the 30s SESSION_ENDED_GRACE_MS without emitting session_ended.
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(transcriptPromise).resolves.toMatchObject({
      outcome: 'failed',
      error: 'session_ended acknowledgement was not received before the socket closed',
    });
  });
});
