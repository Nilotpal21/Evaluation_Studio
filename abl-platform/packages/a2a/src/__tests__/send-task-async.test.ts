import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendTaskAsync, SyncResponseForAsyncRequest } from '../application/send-task-async.js';
import type { SendTaskAsyncParams, SendTaskAsyncDeps } from '../application/send-task-async.js';
import type { A2ATracingPort, EndpointValidator } from '../domain/ports.js';
import type { Task, Message } from '@a2a-js/sdk';

describe('sendTaskAsync', () => {
  let tracing: A2ATracingPort;
  let validator: EndpointValidator;
  let mockClient: { sendMessage: ReturnType<typeof vi.fn> };
  let deps: SendTaskAsyncDeps;

  const baseParams: SendTaskAsyncParams = {
    endpoint: 'https://remote-agent.example.com',
    tenantId: 'tenant-1',
    taskId: 'task-42',
    message: {
      message: {
        kind: 'message',
        messageId: 'msg-1',
        role: 'user',
        parts: [{ kind: 'text', text: 'Process payment' }],
      } as Message,
    },
    pushNotificationUrl: 'https://platform.example.com/api/v1/callbacks/cb-1',
    pushNotificationToken: 'cb-1',
  };

  beforeEach(() => {
    tracing = {
      traceOutbound: vi.fn(),
      traceInbound: vi.fn(),
    };
    validator = {
      validate: vi.fn(),
    };
    mockClient = {
      sendMessage: vi.fn(),
    };
    deps = {
      tracing,
      validator,
      createClient: vi.fn().mockReturnValue(mockClient),
    };
  });

  it('returns Task when remote returns task in working state', async () => {
    const workingTask: Task = {
      id: 'remote-task-1',
      contextId: 'ctx-1',
      kind: 'task',
      status: { state: 'working' },
    };
    mockClient.sendMessage.mockResolvedValue({ result: workingTask });

    const result = await sendTaskAsync(baseParams, deps);
    expect(result.kind).toBe('task');
    expect(result.status.state).toBe('working');
  });

  it('sends with pushNotificationConfig in the message', async () => {
    const workingTask: Task = {
      id: 'remote-task-1',
      contextId: 'ctx-1',
      kind: 'task',
      status: { state: 'working' },
    };
    mockClient.sendMessage.mockResolvedValue({ result: workingTask });

    await sendTaskAsync(baseParams, deps);

    const sentMessage = mockClient.sendMessage.mock.calls[0][0];
    expect(sentMessage.configuration.blocking).toBe(false);
    expect(sentMessage.configuration.pushNotificationConfig).toEqual({
      url: baseParams.pushNotificationUrl,
      token: baseParams.pushNotificationToken,
    });
  });

  it('throws SyncResponseForAsyncRequest when remote returns Message', async () => {
    const syncMessage: Message = {
      kind: 'message',
      messageId: 'msg-resp-1',
      role: 'agent',
      parts: [{ kind: 'text', text: 'Done instantly' }],
    };
    mockClient.sendMessage.mockResolvedValue({ result: syncMessage });

    await expect(sendTaskAsync(baseParams, deps)).rejects.toThrow(SyncResponseForAsyncRequest);
  });

  it('validates endpoint via SSRF before sending', async () => {
    const workingTask: Task = {
      id: 'remote-task-1',
      contextId: 'ctx-1',
      kind: 'task',
      status: { state: 'working' },
    };
    mockClient.sendMessage.mockResolvedValue({ result: workingTask });

    await sendTaskAsync(baseParams, deps);
    expect(validator.validate).toHaveBeenCalled();
  });

  it('traces outbound call with success status', async () => {
    const workingTask: Task = {
      id: 'remote-task-1',
      contextId: 'ctx-1',
      kind: 'task',
      status: { state: 'working' },
    };
    mockClient.sendMessage.mockResolvedValue({ result: workingTask });

    await sendTaskAsync(baseParams, deps);
    expect(tracing.traceOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'success' }),
    );
  });

  it('traces error when remote agent unreachable', async () => {
    mockClient.sendMessage.mockRejectedValue(new Error('Network error'));

    await expect(sendTaskAsync(baseParams, deps)).rejects.toThrow('Network error');
    expect(tracing.traceOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', error: 'Network error' }),
    );
  });
});
