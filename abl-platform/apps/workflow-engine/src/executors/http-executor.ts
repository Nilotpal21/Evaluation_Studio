/**
 * HTTP Step Executor
 *
 * Resolves expressions in URL, headers, and body, validates URL for SSRF,
 * and executes the HTTP request.
 */

import { safeFetch } from '@agent-platform/shared-kernel/security/safe-fetch';
import {
  resolveExpression,
  resolveExpressionTyped,
  resolveExpressionMap,
} from '../context/expression-resolver.js';
import type { WorkflowContextData } from '../context/step-context-schema.js';
import { DEFAULT_STEP_TIMEOUT_MS } from '../constants.js';

export interface HttpStep {
  id: string;
  type: 'http';
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /** Body format from the Studio config — drives the default Content-Type. */
  bodyType?: 'none' | 'json' | 'form' | 'xml' | 'custom';
  timeout?: number;
  retry?: import('../handlers/step-dispatcher.js').RetryConfig;
}

export interface HttpStepResult {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
}

export async function executeHttpRequest(
  step: HttpStep,
  ctx: WorkflowContextData,
): Promise<HttpStepResult> {
  const resolvedUrl = resolveExpression(step.url, ctx);

  // Fail fast if URL is empty or whitespace-only
  if (!resolvedUrl || !resolvedUrl.trim()) {
    throw new Error('HTTP step has no URL configured');
  }

  const resolvedHeaders = step.headers ? resolveExpressionMap(step.headers, ctx) : {};

  const resolvedBody = step.body ? resolveExpressionTyped(step.body, ctx) : undefined;

  const timeout = step.timeout ?? DEFAULT_STEP_TIMEOUT_MS;

  // Serialize body for fetch: objects/arrays get JSON.stringify'd, strings
  // are sent as-is (they may already be JSON, XML, form data, etc.).
  let fetchBody: string | undefined;
  if (resolvedBody !== undefined) {
    fetchBody = typeof resolvedBody === 'string' ? resolvedBody : JSON.stringify(resolvedBody);
  }

  // Derive default Content-Type from the Studio body format.
  // User-supplied headers take precedence (spread after the default).
  const defaultContentType: Record<string, string> =
    step.bodyType === 'xml'
      ? { 'Content-Type': 'application/xml' }
      : step.bodyType === 'form'
        ? { 'Content-Type': 'application/x-www-form-urlencoded' }
        : step.bodyType === 'custom' || step.bodyType === 'none'
          ? {}
          : { 'Content-Type': 'application/json' };

  const response = await safeFetch(resolvedUrl, {
    method: step.method,
    headers: { ...defaultContentType, ...resolvedHeaders },
    body: fetchBody,
    signal: AbortSignal.timeout(timeout),
  });

  // Read body as text first, then attempt JSON parse. Reading json() then
  // falling back to text() fails because the body stream is already consumed.
  const rawText = await response.text();
  let body: unknown = rawText;
  try {
    body = JSON.parse(rawText);
  } catch {
    // Not JSON — keep as raw text
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  // Throw on non-2xx so the workflow handler marks this step as failed
  // and routes execution through the on_failure path
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
    (error as any).httpResult = { statusCode: response.status, body, headers };
    throw error;
  }

  return {
    statusCode: response.status,
    body,
    headers,
  };
}
