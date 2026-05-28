/**
 * SendNotification — Restate activity service for dispatching notifications.
 *
 * Channels:
 * - webhook / slack: Real HTTP POST via fetch() with SSRF protection
 * - email: Stub (requires SMTP service)
 * - websocket: Stub (requires Redis pub/sub)
 */
import * as restate from '@restatedev/restate-sdk';
import { resolveExpression } from '../expression-evaluator.js';
import type { PipelineStepContext, StepOutput } from '../types.js';

const WEBHOOK_TIMEOUT_MS = 10_000;

interface NotificationAttemptResult {
  ok: boolean;
  error?: string;
}

/** Validate webhook URL: protocol check + basic SSRF protection. */
function validateWebhookUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid webhook URL: ${url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Webhook URL must use http or https: ${url}`);
  }
  const hostname = parsed.hostname.toLowerCase();
  const blocked =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    hostname === '169.254.169.254' ||
    hostname === 'metadata.google.internal';
  if (blocked && process.env.NODE_ENV === 'production') {
    throw new Error(`Webhook URL blocked: private/reserved address: ${hostname}`);
  }
}

/** Build notification payload. If body template provided, resolve expressions. */
function buildNotificationBody(input: PipelineStepContext): Record<string, unknown> {
  const bodyTemplate = input.config.body as Record<string, string> | undefined;

  if (bodyTemplate && typeof bodyTemplate === 'object') {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(bodyTemplate)) {
      if (
        typeof value === 'string' &&
        (value.startsWith('steps.') || value.startsWith('pipelineInput.'))
      ) {
        resolved[key] = resolveExpression(value, input.previousSteps, input.pipelineInput);
      } else {
        resolved[key] = value;
      }
    }
    return resolved;
  }

  return {
    tenantId: input.tenantId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    stepOutputs: input.previousSteps,
    timestamp: new Date().toISOString(),
  };
}

export const sendNotificationService = restate.service({
  name: 'SendNotification',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();
      const channel = input.config.channel as string;

      if (!channel) {
        return {
          status: 'fail',
          data: { error: "SendNotification requires 'channel' in config" },
          durationMs: Date.now() - startTime,
        };
      }

      try {
        const attempt = await ctx.run(
          `send-${channel}`,
          async (): Promise<NotificationAttemptResult> => {
            switch (channel) {
              case 'webhook':
              case 'slack': {
                const url = (input.config.webhookUrl ?? input.config.url) as string;
                if (!url) {
                  throw new Error(`${channel} channel requires 'webhookUrl' or 'url' in config`);
                }

                validateWebhookUrl(url);

                const body = buildNotificationBody(input);

                try {
                  const response = await fetch(url, {
                    method: (input.config.method as string) ?? 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      ...((input.config.headers as Record<string, string>) ?? {}),
                    },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
                  });

                  if (!response.ok) {
                    return {
                      ok: false,
                      error: `Webhook returned ${response.status}: ${response.statusText}`,
                    };
                  }
                } catch (error) {
                  return {
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                  };
                }

                return { ok: true };
              }

              case 'email':
                // Stub — requires SMTP service integration
                ctx.console.log(`[SendNotification] Email notification (stub)`);
                return { ok: true };

              case 'websocket':
                // Stub — requires Redis pub/sub integration
                ctx.console.log(`[SendNotification] WebSocket notification (stub)`);
                return { ok: true };

              default:
                throw new Error(`Unknown notification channel: '${channel}'`);
            }
          },
        );

        if (!attempt.ok) {
          return {
            status: 'fail',
            data: { error: attempt.error ?? 'Notification delivery failed' },
            durationMs: Date.now() - startTime,
          };
        }

        return {
          status: 'success',
          data: { sent: true, channel },
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        return {
          status: 'fail',
          data: {
            error: error instanceof Error ? error.message : String(error),
          },
          durationMs: Date.now() - startTime,
        };
      }
    },
  },
});

/** Export the type for use by other Restate services calling this one. */
export type SendNotificationService = typeof sendNotificationService;
