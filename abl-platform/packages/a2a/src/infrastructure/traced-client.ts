import type { A2ATracingPort, EndpointValidator } from '../domain/ports.js';

interface TracedCallInterceptorConfig {
  endpoint: string;
  tenantId: string;
  tracing: A2ATracingPort;
  validator: EndpointValidator;
  allowPrivate?: boolean;
}

export class TracedCallInterceptor {
  readonly endpoint: string;
  readonly tenantId: string;
  private tracing: A2ATracingPort;

  constructor(config: TracedCallInterceptorConfig) {
    config.validator.validate(config.endpoint, config.allowPrivate);
    this.endpoint = config.endpoint;
    this.tenantId = config.tenantId;
    this.tracing = config.tracing;
  }

  traceCall(taskId: string, durationMs: number, status: 'success' | 'error', error?: string): void {
    this.tracing.traceOutbound({
      targetEndpoint: this.endpoint,
      taskId,
      tenantId: this.tenantId,
      durationMs,
      status,
      error,
    });
  }
}
