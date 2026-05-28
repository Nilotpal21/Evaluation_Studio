/**
 * Outbound A2A Capabilities Tests
 *
 * Tests for:
 * - sendTaskStreaming (outbound SSE streaming)
 * - pollTask (task status polling)
 * - cancelRemoteTask (remote task cancellation)
 * - AgentCardCache (capability inspection cache)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendTaskStreaming } from '../application/send-task-streaming.js';
import { pollTask } from '../application/poll-task.js';
import { cancelRemoteTask } from '../application/cancel-task.js';
import { AgentCardCache } from '../infrastructure/agent-card-cache.js';
import type { A2ATracingPort, EndpointValidator } from '../domain/ports.js';
import type { A2AClient } from '@a2a-js/sdk/client';
import type {
  AgentCard,
  Task,
  Message,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from '@a2a-js/sdk';

// =============================================================================
// SHARED HELPERS
// =============================================================================

function createDeps() {
  const tracing: A2ATracingPort = {
    traceOutbound: vi.fn(),
    traceInbound: vi.fn(),
  };
  const validator: EndpointValidator = { validate: vi.fn() };

  const mockClient = {
    sendMessage: vi.fn(),
    sendMessageStream: vi.fn(),
    getAgentCard: vi.fn(),
    getTask: vi.fn(),
    cancelTask: vi.fn(),
    setTaskPushNotificationConfig: vi.fn(),
    getTaskPushNotificationConfig: vi.fn(),
    resubscribeTask: vi.fn(),
    isErrorResponse: vi.fn(),
  } as unknown as A2AClient;

  const createClient = vi.fn().mockReturnValue(mockClient);

  return { tracing, validator, createClient, mockClient };
}

// =============================================================================
// sendTaskStreaming
// =============================================================================

describe('sendTaskStreaming', () => {
  it('yields each SSE event from the remote agent', async () => {
    const { tracing, validator, createClient, mockClient } = createDeps();

    const events: Array<Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent> = [
      {
        kind: 'status-update',
        taskId: 't1',
        contextId: 'c1',
        status: { state: 'working' },
        final: false,
      } as TaskStatusUpdateEvent,
      {
        kind: 'artifact-update',
        taskId: 't1',
        contextId: 'c1',
        artifact: { artifactId: 'a1', parts: [{ kind: 'text', text: 'Hello ' }] },
        append: false,
        lastChunk: false,
      } as TaskArtifactUpdateEvent,
      {
        kind: 'artifact-update',
        taskId: 't1',
        contextId: 'c1',
        artifact: { artifactId: 'a1', parts: [{ kind: 'text', text: 'World' }] },
        append: true,
        lastChunk: true,
      } as TaskArtifactUpdateEvent,
      {
        kind: 'status-update',
        taskId: 't1',
        contextId: 'c1',
        status: { state: 'completed' },
        final: true,
      } as TaskStatusUpdateEvent,
    ];

    (mockClient as any).sendMessageStream = vi.fn(async function* () {
      for (const event of events) {
        yield event;
      }
    });

    const collected = [];
    const stream = sendTaskStreaming(
      {
        endpoint: 'https://remote.example.com',
        tenantId: 'tenant-1',
        taskId: 'task-1',
        message: {
          message: {
            kind: 'message',
            messageId: 'm1',
            role: 'user',
            parts: [{ kind: 'text', text: 'Hi' }],
          },
        },
      },
      { tracing, validator, createClient },
    );

    for await (const event of stream) {
      collected.push(event);
    }

    expect(collected).toHaveLength(4);
    expect(collected[0]).toMatchObject({ kind: 'status-update', status: { state: 'working' } });
    expect(collected[3]).toMatchObject({ kind: 'status-update', status: { state: 'completed' } });
  });

  it('traces the streaming call on success', async () => {
    const { tracing, validator, createClient, mockClient } = createDeps();

    (mockClient as any).sendMessageStream = vi.fn(async function* () {
      yield {
        kind: 'status-update',
        taskId: 't1',
        contextId: 'c1',
        status: { state: 'completed' },
        final: true,
      };
    });

    const stream = sendTaskStreaming(
      {
        endpoint: 'https://r.com',
        tenantId: 't1',
        taskId: 'task-1',
        message: { message: { kind: 'message', messageId: 'm1', role: 'user', parts: [] } },
      },
      { tracing, validator, createClient },
    );
    for await (const _ of stream) {
      /* consume */
    }

    expect(tracing.traceOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'success' }),
    );
  });

  it('traces error when streaming fails', async () => {
    const { tracing, validator, createClient, mockClient } = createDeps();

    (mockClient as any).sendMessageStream = vi.fn(async function* () {
      throw new Error('SSE connection lost');
    });

    const stream = sendTaskStreaming(
      {
        endpoint: 'https://r.com',
        tenantId: 't1',
        taskId: 'task-1',
        message: { message: { kind: 'message', messageId: 'm1', role: 'user', parts: [] } },
      },
      { tracing, validator, createClient },
    );

    await expect(async () => {
      for await (const _ of stream) {
        /* consume */
      }
    }).rejects.toThrow('SSE connection lost');

    expect(tracing.traceOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', error: 'SSE connection lost' }),
    );
  });
});

// =============================================================================
// pollTask
// =============================================================================

describe('pollTask', () => {
  it('returns the task with current status', async () => {
    const { tracing, validator, createClient, mockClient } = createDeps();

    const task: Task = {
      id: 'task-1',
      contextId: 'ctx-1',
      kind: 'task',
      status: { state: 'working' },
    } as Task;

    (mockClient as any).getTask = vi.fn().mockResolvedValue({
      jsonrpc: '2.0',
      id: '1',
      result: task,
    });

    const result = await pollTask(
      { endpoint: 'https://remote.com', tenantId: 't1', taskId: 'task-1' },
      { tracing, validator, createClient },
    );

    expect(result.id).toBe('task-1');
    expect(result.status.state).toBe('working');
    expect(tracing.traceOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'success' }),
    );
  });

  it('throws when remote returns error', async () => {
    const { tracing, validator, createClient, mockClient } = createDeps();

    (mockClient as any).getTask = vi.fn().mockResolvedValue({
      jsonrpc: '2.0',
      id: '1',
      error: { code: -32602, message: 'Task not found' },
    });

    await expect(
      pollTask(
        { endpoint: 'https://remote.com', tenantId: 't1', taskId: 'task-x' },
        { tracing, validator, createClient },
      ),
    ).rejects.toThrow('Task not found');
  });

  it('passes historyLength when provided', async () => {
    const { tracing, validator, createClient, mockClient } = createDeps();

    (mockClient as any).getTask = vi.fn().mockResolvedValue({
      jsonrpc: '2.0',
      id: '1',
      result: { id: 'task-1', contextId: 'c1', kind: 'task', status: { state: 'completed' } },
    });

    await pollTask(
      { endpoint: 'https://remote.com', tenantId: 't1', taskId: 'task-1', historyLength: 5 },
      { tracing, validator, createClient },
    );

    expect((mockClient as any).getTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-1', historyLength: 5 }),
    );
  });
});

// =============================================================================
// cancelRemoteTask
// =============================================================================

describe('cancelRemoteTask', () => {
  it('cancels a remote task and returns updated task', async () => {
    const { tracing, validator, createClient, mockClient } = createDeps();

    (mockClient as any).cancelTask = vi.fn().mockResolvedValue({
      jsonrpc: '2.0',
      id: '1',
      result: { id: 'task-1', contextId: 'c1', kind: 'task', status: { state: 'canceled' } },
    });

    const result = await cancelRemoteTask(
      { endpoint: 'https://remote.com', tenantId: 't1', taskId: 'task-1' },
      { tracing, validator, createClient },
    );

    expect(result.status.state).toBe('canceled');
    expect(tracing.traceOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'success' }),
    );
  });

  it('throws when remote returns error', async () => {
    const { tracing, validator, createClient, mockClient } = createDeps();

    (mockClient as any).cancelTask = vi.fn().mockResolvedValue({
      jsonrpc: '2.0',
      id: '1',
      error: { code: -32602, message: 'Task not cancelable' },
    });

    await expect(
      cancelRemoteTask(
        { endpoint: 'https://remote.com', tenantId: 't1', taskId: 'task-1' },
        { tracing, validator, createClient },
      ),
    ).rejects.toThrow('Task not cancelable');
  });
});

// =============================================================================
// AgentCardCache
// =============================================================================

describe('AgentCardCache', () => {
  const card: AgentCard = {
    name: 'Remote Agent',
    description: 'Test',
    url: 'https://remote.com/a2a',
    version: '1.0.0',
    capabilities: { streaming: true, pushNotifications: true },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [],
  };

  it('stores and retrieves an agent card', () => {
    const cache = new AgentCardCache();
    cache.set('https://remote.com', card);
    expect(cache.get('https://remote.com')).toEqual(card);
  });

  it('returns undefined for unknown endpoints', () => {
    const cache = new AgentCardCache();
    expect(cache.get('https://unknown.com')).toBeUndefined();
  });

  it('expires entries after TTL', () => {
    const cache = new AgentCardCache(100); // 100ms TTL
    cache.set('https://remote.com', card);

    // Simulate time passing by manually setting expiresAt in the past
    // (we can't use fake timers on the cache easily, so we set a short TTL and verify)
    expect(cache.get('https://remote.com')).toEqual(card); // Still valid

    // Use a negative TTL to ensure immediate expiry (expiresAt in the past)
    const shortCache = new AgentCardCache(-1);
    shortCache.set('https://remote.com', card);
    expect(shortCache.get('https://remote.com')).toBeUndefined();
  });

  it('evicts oldest entry when at max capacity', () => {
    const cache = new AgentCardCache();

    // Fill to capacity (100)
    for (let i = 0; i < 100; i++) {
      cache.set(`https://agent-${i}.com`, { ...card, name: `Agent ${i}` });
    }
    expect(cache.size).toBe(100);

    // Adding one more should evict the oldest (agent-0)
    cache.set('https://agent-new.com', { ...card, name: 'New Agent' });
    expect(cache.size).toBe(100);
    expect(cache.get('https://agent-0.com')).toBeUndefined();
    expect(cache.get('https://agent-new.com')).toBeDefined();
  });

  it('clears all entries', () => {
    const cache = new AgentCardCache();
    cache.set('https://a.com', card);
    cache.set('https://b.com', card);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
