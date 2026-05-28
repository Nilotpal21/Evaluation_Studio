import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendTask } from '../application/send-task.js';
import type { SendTaskDeps, SendTaskParams } from '../application/send-task.js';
import type { A2ATracingPort, EndpointValidator } from '../domain/ports.js';
import type { A2AClient } from '@a2a-js/sdk/client';
import type { MessageSendParams, SendMessageResponse, Task, Message } from '@a2a-js/sdk';

describe('SendTaskUseCase', () => {
  let tracing: A2ATracingPort;
  let validator: EndpointValidator;
  let mockClient: { sendMessage: ReturnType<typeof vi.fn> };
  let deps: SendTaskDeps;

  const TASK_ID = 'task-42';
  const TENANT_ID = 'tenant-1';
  const ENDPOINT = 'https://remote-agent.example.com';

  const sampleMessage: MessageSendParams = {
    message: {
      kind: 'message',
      messageId: 'msg-1',
      role: 'user',
      parts: [{ kind: 'text', text: 'Hello remote agent' }],
    },
  };

  const sampleTask: Task = {
    id: TASK_ID,
    contextId: 'ctx-1',
    kind: 'task',
    status: { state: 'completed' },
  };

  const successResponse: SendMessageResponse = {
    id: '1',
    jsonrpc: '2.0',
    result: sampleTask,
  } as SendMessageResponse;

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

  it('validates endpoint before sending', async () => {
    mockClient.sendMessage.mockResolvedValue(successResponse);

    await sendTask(
      { endpoint: ENDPOINT, tenantId: TENANT_ID, taskId: TASK_ID, message: sampleMessage },
      deps,
    );

    expect(validator.validate).toHaveBeenCalledWith(ENDPOINT, undefined);
  });

  it('sends message via SDK client and returns result', async () => {
    mockClient.sendMessage.mockResolvedValue(successResponse);

    const result = await sendTask(
      { endpoint: ENDPOINT, tenantId: TENANT_ID, taskId: TASK_ID, message: sampleMessage },
      deps,
    );

    expect(deps.createClient).toHaveBeenCalledWith(ENDPOINT);
    expect(mockClient.sendMessage).toHaveBeenCalledWith(sampleMessage);
    expect(result).toEqual(sampleTask);
  });

  it('traces successful calls with status success', async () => {
    mockClient.sendMessage.mockResolvedValue(successResponse);

    await sendTask(
      { endpoint: ENDPOINT, tenantId: TENANT_ID, taskId: TASK_ID, message: sampleMessage },
      deps,
    );

    expect(tracing.traceOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        targetEndpoint: ENDPOINT,
        taskId: TASK_ID,
        tenantId: TENANT_ID,
        status: 'success',
      }),
    );
    // durationMs should be a number >= 0
    const call = (tracing.traceOutbound as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(typeof call.durationMs).toBe('number');
    expect(call.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('traces failed calls with status error and re-throws', async () => {
    const networkError = new Error('Connection refused');
    mockClient.sendMessage.mockRejectedValue(networkError);

    await expect(
      sendTask(
        { endpoint: ENDPOINT, tenantId: TENANT_ID, taskId: TASK_ID, message: sampleMessage },
        deps,
      ),
    ).rejects.toThrow('Connection refused');

    expect(tracing.traceOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        targetEndpoint: ENDPOINT,
        taskId: TASK_ID,
        tenantId: TENANT_ID,
        status: 'error',
        error: 'Connection refused',
      }),
    );
  });

  it('throws immediately on SSRF-blocked endpoint without calling SDK', async () => {
    (validator.validate as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('SSRF blocked: 127.0.0.1 is a private/reserved address');
    });

    await expect(
      sendTask(
        {
          endpoint: 'http://127.0.0.1/a2a',
          tenantId: TENANT_ID,
          taskId: TASK_ID,
          message: sampleMessage,
        },
        deps,
      ),
    ).rejects.toThrow('SSRF blocked');

    // SDK client should never be created for blocked endpoints
    expect(deps.createClient).not.toHaveBeenCalled();
    expect(mockClient.sendMessage).not.toHaveBeenCalled();
  });

  it('throws when remote agent returns JSON-RPC error response', async () => {
    const errorResponse: SendMessageResponse = {
      id: '1',
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Invalid request' },
    } as SendMessageResponse;
    mockClient.sendMessage.mockResolvedValue(errorResponse);

    await expect(
      sendTask(
        { endpoint: ENDPOINT, tenantId: TENANT_ID, taskId: TASK_ID, message: sampleMessage },
        deps,
      ),
    ).rejects.toThrow('Remote agent returned error');

    expect(tracing.traceOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
      }),
    );
  });

  it('passes allowPrivate flag to endpoint validator', async () => {
    mockClient.sendMessage.mockResolvedValue(successResponse);

    await sendTask(
      {
        endpoint: ENDPOINT,
        tenantId: TENANT_ID,
        taskId: TASK_ID,
        message: sampleMessage,
        allowPrivate: true,
      },
      deps,
    );

    expect(validator.validate).toHaveBeenCalledWith(ENDPOINT, true);
  });
});
