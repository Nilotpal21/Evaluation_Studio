/**
 * PushNotificationDeliveryService — delivers push notifications from this
 * platform (as server) to A2A callers.
 *
 * When this platform completes a long-running task, it POSTs a JSON-RPC
 * notification to the caller's registered push notification URL per the
 * A2A specification.
 */

import type { EndpointValidator, A2ATracingPort } from '../domain/ports.js';

export interface PushNotificationConfig {
  url: string;
  token?: string;
  authentication?: { schemes: string[] };
}

export class PushNotificationDeliveryService {
  constructor(
    private readonly validator: EndpointValidator,
    private readonly tracing: A2ATracingPort,
  ) {}

  async deliverTaskUpdate(
    config: PushNotificationConfig,
    taskId: string,
    state: string,
    message?: unknown,
  ): Promise<void> {
    // Validate URL against SSRF rules
    this.validator.validate(config.url);

    const payload = {
      jsonrpc: '2.0' as const,
      method: 'tasks/pushNotification',
      params: {
        id: taskId,
        status: { state },
        ...(message ? { message } : {}),
      },
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (config.token) {
      headers['Authorization'] = `Bearer ${config.token}`;
    }

    const start = Date.now();
    try {
      const response = await fetch(config.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        throw new Error(`Push notification delivery failed: HTTP ${response.status}`);
      }

      this.tracing.traceOutbound({
        targetEndpoint: config.url,
        taskId,
        tenantId: 'push-notification',
        durationMs: Date.now() - start,
        status: 'success',
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.tracing.traceOutbound({
        targetEndpoint: config.url,
        taskId,
        tenantId: 'push-notification',
        durationMs: Date.now() - start,
        status: 'error',
        error: errorMessage,
      });
      throw error;
    }
  }
}
