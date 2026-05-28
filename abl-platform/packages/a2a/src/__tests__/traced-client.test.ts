import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TracedCallInterceptor } from '../infrastructure/traced-client.js';
import type { A2ATracingPort, EndpointValidator } from '../domain/ports.js';

describe('TracedCallInterceptor', () => {
  let tracing: A2ATracingPort;
  let validator: EndpointValidator;

  beforeEach(() => {
    tracing = {
      traceOutbound: vi.fn(),
      traceInbound: vi.fn(),
    };
    validator = {
      validate: vi.fn(),
    };
  });

  it('validates endpoint on creation', () => {
    new TracedCallInterceptor({
      endpoint: 'https://remote.example.com',
      tenantId: 'tenant-1',
      tracing,
      validator,
    });
    expect(validator.validate).toHaveBeenCalledWith('https://remote.example.com', undefined);
  });

  it('throws if SSRF validation fails', () => {
    (validator.validate as any).mockImplementation(() => {
      throw new Error('SSRF blocked');
    });
    expect(
      () =>
        new TracedCallInterceptor({
          endpoint: 'http://127.0.0.1',
          tenantId: 'tenant-1',
          tracing,
          validator,
        }),
    ).toThrow('SSRF blocked');
  });

  it('exposes endpoint and tenantId', () => {
    const interceptor = new TracedCallInterceptor({
      endpoint: 'https://remote.example.com',
      tenantId: 'tenant-1',
      tracing,
      validator,
    });
    expect(interceptor.endpoint).toBe('https://remote.example.com');
    expect(interceptor.tenantId).toBe('tenant-1');
  });

  it('traceCall emits outbound trace event', () => {
    const interceptor = new TracedCallInterceptor({
      endpoint: 'https://remote.example.com',
      tenantId: 'tenant-1',
      tracing,
      validator,
    });
    interceptor.traceCall('task-123', 200, 'success');
    expect(tracing.traceOutbound).toHaveBeenCalledWith({
      targetEndpoint: 'https://remote.example.com',
      taskId: 'task-123',
      tenantId: 'tenant-1',
      durationMs: 200,
      status: 'success',
      error: undefined,
    });
  });
});
