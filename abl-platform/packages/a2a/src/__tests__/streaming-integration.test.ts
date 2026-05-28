/**
 * A2A Streaming Integration Tests
 *
 * Verifies end-to-end behavior of the inbound SSE streaming path through
 * AgentExecutorAdapter. Tests all three modes:
 *   1. Sync (no streaming port) — single Message event
 *   2. Streaming (with streaming port) — incremental artifact events
 *   3. Async error — failed status terminates the stream
 *
 * Also tests the outbound async path event structure for completeness.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AgentExecutorAdapter,
  a2aContextStorage,
} from '../infrastructure/agent-executor-adapter.js';
import type { A2ATracingPort, AgentExecutionPort, A2ARequestContext } from '../domain/ports.js';
import type { ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import type { Message } from '@a2a-js/sdk';

// =============================================================================
// HELPERS
// =============================================================================

const AGENT_NAME = 'integration-agent';
const TENANT_ID = 'tenant-integration';
const TASK_ID = 'task-int-1';
const CONTEXT_ID = 'ctx-int-1';

const TEST_CONTEXT: A2ARequestContext = {
  tenantId: TENANT_ID,
  projectId: 'proj-int-1',
  connectionId: 'conn-int-1',
};

function withContext<T>(fn: () => Promise<T>): Promise<T> {
  return a2aContextStorage.run(TEST_CONTEXT, fn);
}

function makeRequestContext(text: string): RequestContext {
  return {
    userMessage: {
      kind: 'message',
      messageId: 'msg-int-1',
      role: 'user',
      parts: [{ kind: 'text', text }],
    } as Message,
    taskId: TASK_ID,
    contextId: CONTEXT_ID,
  } as RequestContext;
}

function createEventBus(): ExecutionEventBus {
  return {
    publish: vi.fn(),
    finished: vi.fn(),
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    removeAllListeners: vi.fn().mockReturnThis(),
  } as unknown as ExecutionEventBus;
}

function createTracing(): A2ATracingPort {
  return {
    traceOutbound: vi.fn(),
    traceInbound: vi.fn(),
  };
}

function getPublishedEvents(eventBus: ExecutionEventBus): unknown[] {
  return (eventBus.publish as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
}

function makePort(overrides: Partial<AgentExecutionPort> = {}): AgentExecutionPort {
  return {
    executeMessage: vi.fn().mockResolvedValue({
      response: 'default',
      action: { type: 'complete' },
    }),
    getSessionDetail: vi.fn().mockReturnValue(null),
    createSession: vi.fn().mockResolvedValue('new-session'),
    ...overrides,
  };
}

// =============================================================================
// SYNC MODE INTEGRATION
// =============================================================================

describe('A2A Sync Mode (no streaming)', () => {
  let eventBus: ExecutionEventBus;
  let tracing: A2ATracingPort;

  beforeEach(() => {
    eventBus = createEventBus();
    tracing = createTracing();
  });

  it('produces working-status → message → final-status event sequence', async () => {
    const port = makePort({
      executeMessage: vi.fn().mockResolvedValue({
        response: 'Risk analysis shows low risk.',
        action: { type: 'complete' },
      }),
    });

    const adapter = new AgentExecutorAdapter({
      agentName: AGENT_NAME,
      executionPort: port,
      tracing,
    });

    await withContext(() =>
      adapter.execute(makeRequestContext('Analyze contract risks'), eventBus),
    );

    const events = getPublishedEvents(eventBus);

    // Event 0: working status
    expect(events[0]).toMatchObject({
      kind: 'status-update',
      taskId: TASK_ID,
      contextId: CONTEXT_ID,
      status: { state: 'working' },
      final: false,
    });

    // Event 1: completed Task (populates InMemoryTaskStore)
    expect((events[1] as any).kind).toBe('task');
    expect((events[1] as any).status.state).toBe('completed');

    // Event 2: full response message (sync path)
    expect((events[2] as any).kind).toBe('message');
    expect((events[2] as any).role).toBe('agent');
    expect((events[2] as any).parts[0].text).toBe('Risk analysis shows low risk.');

    // Event 3: final completed status
    expect(events[3]).toMatchObject({
      kind: 'status-update',
      taskId: TASK_ID,
      status: { state: 'completed' },
      final: true,
    });

    expect(eventBus.finished).toHaveBeenCalledOnce();
    expect(events).toHaveLength(4);
  });

  it('emits completed final state even when action is not complete', async () => {
    const port = makePort({
      executeMessage: vi.fn().mockResolvedValue({
        response: 'Handing off to specialist.',
        action: { type: 'handoff' },
      }),
    });

    const adapter = new AgentExecutorAdapter({
      agentName: AGENT_NAME,
      executionPort: port,
      tracing,
    });

    await withContext(() => adapter.execute(makeRequestContext('Help'), eventBus));

    const events = getPublishedEvents(eventBus);
    const finalStatus = events[events.length - 1] as any;
    expect(finalStatus.status.state).toBe('completed');
    expect(finalStatus.final).toBe(true);
  });
});

// =============================================================================
// STREAMING MODE INTEGRATION
// =============================================================================

describe('A2A Streaming Mode (SSE)', () => {
  let eventBus: ExecutionEventBus;
  let tracing: A2ATracingPort;

  beforeEach(() => {
    eventBus = createEventBus();
    tracing = createTracing();
  });

  it('produces working-status → N artifact-updates → last-chunk → final-status', async () => {
    const chunks = ['Risk ', 'analysis ', 'shows ', 'low risk.'];

    const port = makePort({
      executeMessage: vi.fn(),
      executeMessageStreaming: vi.fn(async (_sessionId, _message, onChunk) => {
        for (const chunk of chunks) {
          onChunk(chunk);
        }
        return { response: chunks.join(''), action: { type: 'complete' } };
      }),
    });

    const adapter = new AgentExecutorAdapter({
      agentName: AGENT_NAME,
      executionPort: port,
      tracing,
    });

    await withContext(() => adapter.execute(makeRequestContext('Analyze'), eventBus));

    const events = getPublishedEvents(eventBus);

    // Event 0: working status
    expect(events[0]).toMatchObject({
      kind: 'status-update',
      status: { state: 'working' },
      final: false,
    });

    // Events 1-4: artifact chunks
    for (let i = 0; i < chunks.length; i++) {
      const event = events[i + 1] as any;
      expect(event.kind).toBe('artifact-update');
      expect(event.taskId).toBe(TASK_ID);
      expect(event.artifact.parts[0].text).toBe(chunks[i]);
      expect(event.append).toBe(i > 0);
      expect(event.lastChunk).toBe(false);
    }

    // Event 5: last-chunk marker
    const lastChunk = events[chunks.length + 1] as any;
    expect(lastChunk.kind).toBe('artifact-update');
    expect(lastChunk.lastChunk).toBe(true);
    expect(lastChunk.append).toBe(true);

    // Event 6: completed Task (populates InMemoryTaskStore)
    const taskEvent = events[chunks.length + 2] as any;
    expect(taskEvent.kind).toBe('task');
    expect(taskEvent.status.state).toBe('completed');

    // Event 7: final response Message (SDK ResultManager requires this for blocking path)
    const responseMessage = events[chunks.length + 3] as any;
    expect(responseMessage.kind).toBe('message');
    expect(responseMessage.role).toBe('agent');
    expect(responseMessage.parts[0].text).toBe(chunks.join(''));

    // Event 8: final completed status
    const finalStatus = events[chunks.length + 4] as any;
    expect(finalStatus.kind).toBe('status-update');
    expect(finalStatus.status.state).toBe('completed');
    expect(finalStatus.final).toBe(true);

    // Total: 1 working + 4 chunks + 1 last-chunk + 1 task + 1 message + 1 final = 9
    expect(events).toHaveLength(9);
    expect(eventBus.finished).toHaveBeenCalledOnce();
  });

  it('all artifact events share the same artifactId', async () => {
    const port = makePort({
      executeMessage: vi.fn(),
      executeMessageStreaming: vi.fn(async (_sessionId, _message, onChunk) => {
        onChunk('Hello ');
        onChunk('World');
        return { response: 'Hello World', action: { type: 'complete' } };
      }),
    });

    const adapter = new AgentExecutorAdapter({
      agentName: AGENT_NAME,
      executionPort: port,
      tracing,
    });

    await withContext(() => adapter.execute(makeRequestContext('Hi'), eventBus));

    const events = getPublishedEvents(eventBus);
    const artifactEvents = events.filter((e: any) => e.kind === 'artifact-update');
    const artifactIds = artifactEvents.map((e: any) => e.artifact.artifactId);

    // All should share the same ID
    expect(new Set(artifactIds).size).toBe(1);
    expect(artifactIds[0]).toBe(`stream-${TASK_ID}`);
  });

  it('does not call sync executeMessage when streaming port is available', async () => {
    const port = makePort({
      executeMessage: vi.fn(),
      executeMessageStreaming: vi.fn(async () => {
        return { response: 'Streamed', action: { type: 'complete' } };
      }),
    });

    const adapter = new AgentExecutorAdapter({
      agentName: AGENT_NAME,
      executionPort: port,
      tracing,
    });

    await withContext(() => adapter.execute(makeRequestContext('Test'), eventBus));

    expect(port.executeMessageStreaming).toHaveBeenCalledOnce();
    expect(port.executeMessage).not.toHaveBeenCalled();
  });

  it('emits failed status when streaming throws mid-execution', async () => {
    const port = makePort({
      executeMessage: vi.fn(),
      executeMessageStreaming: vi.fn(async (_sessionId, _message, onChunk) => {
        onChunk('Partial ');
        throw new Error('LLM provider connection lost');
      }),
    });

    const adapter = new AgentExecutorAdapter({
      agentName: AGENT_NAME,
      executionPort: port,
      tracing,
    });

    await expect(
      withContext(() => adapter.execute(makeRequestContext('Analyze'), eventBus)),
    ).rejects.toThrow('LLM provider connection lost');

    const events = getPublishedEvents(eventBus);

    // working status
    expect(events[0]).toMatchObject({
      kind: 'status-update',
      status: { state: 'working' },
      final: false,
    });

    // partial artifact chunk was emitted before error
    const artifactEvents = events.filter((e: any) => e.kind === 'artifact-update');
    expect(artifactEvents.length).toBeGreaterThanOrEqual(1);
    expect((artifactEvents[0] as any).artifact.parts[0].text).toBe('Partial ');

    // failed final status
    const failedEvent = events.find(
      (e: any) => e.kind === 'status-update' && e.final === true,
    ) as any;
    expect(failedEvent.status.state).toBe('failed');
    expect(eventBus.finished).toHaveBeenCalledOnce();
  });
});

// =============================================================================
// ERROR HANDLING
// =============================================================================

describe('A2A Error Handling', () => {
  let eventBus: ExecutionEventBus;
  let tracing: A2ATracingPort;

  beforeEach(() => {
    eventBus = createEventBus();
    tracing = createTracing();
  });

  it('non-Error throws are traced with String conversion', async () => {
    const port = makePort({
      executeMessage: vi.fn().mockRejectedValue('raw string error'),
    });

    const adapter = new AgentExecutorAdapter({
      agentName: AGENT_NAME,
      executionPort: port,
      tracing,
    });

    await expect(
      withContext(() => adapter.execute(makeRequestContext('Fail'), eventBus)),
    ).rejects.toBeDefined();

    expect(tracing.traceInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        error: 'raw string error',
      }),
    );
  });
});
