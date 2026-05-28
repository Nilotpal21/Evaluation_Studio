/**
 * Async Webhook Step Executor
 *
 * Sends an outbound HTTP request with a callback URL injected into the payload.
 * The workflow pauses until the external system calls back with a result.
 *
 * The actual durable wait is handled by Restate's ctx.promise() in the workflow handler.
 * This executor prepares the outbound request and returns the callback metadata.
 */

import { assertUrlSafeForSSRF } from '@agent-platform/shared-kernel/security';
import { resolveExpression, resolveExpressionTyped } from '../context/expression-resolver.js';
import type { WorkflowContextData } from '../context/step-context-schema.js';
import { DEFAULT_CALLBACK_TIMEOUT_MS } from '../constants.js';

export interface AsyncWebhookStep {
  id: string;
  type: 'async_webhook';
  url: string;
  method?: 'POST' | 'PUT' | 'PATCH';
  headers?: Record<string, string>;
  body?: Record<string, string>;
  /** Where in the body to inject the callback URL (dot path). Defaults to "callbackUrl". */
  callbackUrlField?: string;
  timeout?: number;
  retry?: import('../handlers/step-dispatcher.js').RetryConfig;
}

export interface AsyncWebhookRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  callbackId: string;
}

export interface CallbackUrlBuilder {
  buildCallbackUrl(executionId: string, stepId: string, tenantId?: string): string;
}

/**
 * Build the outbound webhook request with a callback URL injected.
 * Does NOT send the request — that's the handler's responsibility.
 */
export function buildAsyncWebhookRequest(
  step: AsyncWebhookStep,
  ctx: WorkflowContextData,
  callbackUrlBuilder: CallbackUrlBuilder,
): AsyncWebhookRequest {
  const resolvedUrl = resolveExpression(step.url, ctx);
  assertUrlSafeForSSRF(resolvedUrl);
  const callbackId = `${ctx.workflow.executionId}:${step.id}`;
  const callbackUrl = callbackUrlBuilder.buildCallbackUrl(
    ctx.workflow.executionId,
    step.id,
    ctx.tenant.tenantId,
  );

  // Resolve headers
  const headers: Record<string, string> = {};
  if (step.headers) {
    for (const [key, value] of Object.entries(step.headers)) {
      headers[key] = resolveExpression(value, ctx);
    }
  }

  // Resolve body and inject callback URL
  const body: Record<string, unknown> = {};
  if (step.body) {
    for (const [key, value] of Object.entries(step.body)) {
      body[key] = resolveExpressionTyped(value, ctx);
    }
  }

  const callbackField = step.callbackUrlField ?? 'callbackUrl';
  body[callbackField] = callbackUrl;

  return {
    url: resolvedUrl,
    method: step.method ?? 'POST',
    headers,
    body,
    callbackId,
  };
}

/**
 * Get the effective timeout for the async webhook wait.
 */
export function getAsyncWebhookTimeout(step: AsyncWebhookStep): number {
  return step.timeout ?? DEFAULT_CALLBACK_TIMEOUT_MS;
}
